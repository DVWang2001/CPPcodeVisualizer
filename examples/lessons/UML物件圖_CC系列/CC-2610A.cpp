// UML 物件圖教案 CC-2610A：三角形的重心與內心（組合：Triangle 有三個 Point）
// （改寫自 CF 題目 CC-2610A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<cmath>
using namespace std;
class Point{
   double m_x,m_y;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point add(const Point b)const{return Point(m_x+b.m_x,m_y+b.m_y);}
   Point mul(double b)const{return Point(m_x*b,m_y*b);}
   Point div(double b)const{return mul(1/b);}
   Point sub(const Point &a)const{return add(a.mul(-1.));}
   double toDouble()const{return sqrt(m_x*m_x+m_y*m_y);}
   void read(){cin>>m_x>>m_y;}
   void print()const{cout<<"("<<m_x<<","<<m_y<<")";}
};

class Triangle{public:
   Point A,B,C;
   void read(){A.read();B.read();C.read();}
   void print(){
      Point G=A.add(B).add(C).div(3);
      double a=B.sub(C).toDouble();
      double b=C.sub(A).toDouble();
      double c=A.sub(B).toDouble();
      Point I=A.mul(a).add(B.mul(b)).add(C.mul(c)).div(a+b+c);
      cout<<"G:";G.print();cout<<endl;
      cout<<"I:";I.print();
   }
};

int main(){
   Triangle tri;tri.read();
   tri.print();cout<<endl;  //@ @guide uml:tri
   return 0;
}
