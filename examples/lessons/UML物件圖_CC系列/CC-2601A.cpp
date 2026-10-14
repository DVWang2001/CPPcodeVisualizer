// UML 物件圖教案 CC-2601A：矩形的對角向量（組合：Rectangle 有兩個 Point）
// （改寫自 CF 題目 CC-2601A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
using namespace std;
class Point{public:
   double m_x,m_y;
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point sub(Point b){return Point(m_x-b.m_x,m_y-b.m_y);}
   void read(){cin>>m_x>>m_y;}
};

class Rectangle{public:
   Point a,b;
   void read(){a.read();b.read();}
   void print(){
      Point d=b.sub(a);
      cout<<d.m_x<<" "<<d.m_y;
   }
};

int main(){
   int n;cin>>n;
   while(n--){
      Rectangle rec;rec.read();
      rec.print();cout<<endl;  //@ @guide uml:rec
   }
   return 0;
}
