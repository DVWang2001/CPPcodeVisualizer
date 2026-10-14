// UML 物件圖教案 CC-26D05：箭頭長度（組合：Arrow 有兩個 Complex）
// （改寫自 CF 題目 CC-26D05：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<cmath>
using namespace std;
class Complex{public:
   double x,y;
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex sub(const Complex& b)const{return Complex(x-b.x,y-b.y);}
   void read(){
      char c1,c2;
      cin>>x>>c1>>y>>c2;
      if(c1=='-')y*=-1;
   }
};
class Arrow{public:
   Complex a,b;
   double len(){
      Complex d=a.sub(b);
      return sqrt(d.x*d.x+d.y*d.y);
   }
   void read(){a.read();b.read();}
};

int main(){
   int n;cin>>n;
   while(n--){
      Arrow ar;ar.read();
      cout<<ar.len()<<endl;  //@ @guide uml:ar
   }
   return 0;
}
